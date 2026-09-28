import process from "node:process";
import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerActiveDebugProxyCapture } from "../proxy-capture/runtime-cleanup.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getGatewayRunRuntimeHooks } from "./gateway-cli/runtime-hooks.js";
import { getPendingCliDisposers } from "./runtime-cleanup.js";
import {
  registerSignalExitBarrier,
  registerSignalExitFinalizer,
  waitForSignalExitBarriers,
} from "./signal-exit-barrier.js";

export function makeProxyHandle() {
  return {
    proxyUrl: "http://127.0.0.1:19876",
    stop: vi.fn(async () => {}),
    kill: vi.fn(),
  };
}

function emitToAddedListeners(
  event: "SIGTERM" | "SIGINT" | "exit",
  before: ReadonlySet<(...args: never[]) => unknown>,
  ...args: unknown[]
): void {
  for (const listener of process.listeners(event)) {
    if (!before.has(listener)) {
      (listener as (...listenerArgs: unknown[]) => void)(...args);
    }
  }
}

export function registerRunMainProxyExitTests({
  runCli,
  startProxyMock,
  stopProxyMock,
  tryRouteCliMock,
  loadConfigMock,
  commanderParseAsyncMock,
  runGatewayBeforeHook,
}: {
  runCli: (argv: string[]) => Promise<void>;
  startProxyMock: Mock<(config: unknown) => Promise<unknown>>;
  stopProxyMock: Mock<(handle: unknown) => Promise<void>>;
  tryRouteCliMock: Mock;
  loadConfigMock: Mock<(...args: never[]) => OpenClawConfig>;
  commanderParseAsyncMock: Mock<() => Promise<void>>;
  runGatewayBeforeHook: () => Promise<void>;
}): void {
  it.each([
    { signal: "SIGTERM" as const, proxyExitCode: 143 },
    { signal: "SIGINT" as const, proxyExitCode: 130 },
  ])(
    "lets the gateway run loop own $signal exit while the managed proxy is active",
    async ({ signal, proxyExitCode }) => {
      // The run loop drains active work and releases its lock and owner lease
      // before it exits. A proxy-owned exit would cut that drain off.
      const finalHandle = makeProxyHandle();
      loadConfigMock.mockReturnValueOnce({ proxy: { proxyUrl: "http://127.0.0.1:19876" } });
      startProxyMock.mockResolvedValueOnce(makeProxyHandle()).mockResolvedValueOnce(finalHandle);
      const signalListenersBefore = new Set(process.listeners(signal));
      const exitListenersBefore = new Set(process.listeners("exit"));
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined as never) as typeof process.exit);
      const gatewayStop = vi.fn();
      commanderParseAsyncMock.mockImplementationOnce(async () => {
        await runGatewayBeforeHook();
        await getGatewayRunRuntimeHooks().refreshManagedProxy?.({
          proxyUrl: "http://127.0.0.1:29876",
        });
        // Hard exit still releases process-wide proxy routing synchronously.
        emitToAddedListeners("exit", exitListenersBefore, 0);
        expect(finalHandle.kill).toHaveBeenCalledWith("SIGTERM");
        // Stand-in for the run loop, which installs its handler after the refresh.
        process.once(signal, gatewayStop);
        // Deliver as process.emit would, but only to listeners this run added,
        // so the test runner's own handlers stay out of it.
        emitToAddedListeners(signal, signalListenersBefore, signal);
        expect(gatewayStop).toHaveBeenCalledOnce();
        await waitForSignalExitBarriers();
        expect(exitSpy).not.toHaveBeenCalledWith(proxyExitCode);
      });

      try {
        await runCli(["node", "openclaw", "gateway", "run"]);
      } finally {
        process.off(signal, gatewayStop);
        exitSpy.mockRestore();
      }

      expect(exitSpy).not.toHaveBeenCalled();
    },
  );
  it.each([
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
  ])(
    "stops the managed proxy and drains capture before $signal exit",
    async ({ signal, exitCode }) => {
      const handle = makeProxyHandle();
      startProxyMock.mockResolvedValueOnce(handle);
      let resolveRoute: (value: boolean) => void = () => {};
      tryRouteCliMock.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          resolveRoute = resolve;
        }),
      );

      const processOnceSpy = vi.spyOn(process, "once");
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
        void code;
        return undefined as never;
      }) as typeof process.exit);
      let finishCompanionCleanup: (() => void) | undefined;
      const unregisterCompanionCleanup = registerSignalExitBarrier(
        () =>
          new Promise<void>((resolve) => {
            finishCompanionCleanup = resolve;
          }),
      );
      const captureFinished = createDeferredCore();
      const cleanupOrder: string[] = [];
      const captureFinalizer = vi.fn(async () => {
        await captureFinished.promise;
        cleanupOrder.push("capture");
        unregisterCapture();
      });
      const unregisterCapture = registerActiveDebugProxyCapture(captureFinalizer);
      const retireWorkerSource = vi.fn(async () => {
        cleanupOrder.push("worker-source");
      });
      const unregisterWorkerSource = registerSignalExitFinalizer(retireWorkerSource);
      let runPromise: Promise<unknown> | undefined;

      try {
        runPromise = runCli(["node", "openclaw", "plugins", "marketplace", "list"]);
        await vi.waitFor(() => {
          expect(
            processOnceSpy.mock.calls.some(
              ([event, listener]) => event === signal && typeof listener === "function",
            ),
          ).toBe(true);
        });

        const signalHandler = processOnceSpy.mock.calls.find(([event]) => event === signal)?.[1];
        if (typeof signalHandler !== "function") {
          throw new Error(`${signal} handler was not registered`);
        }
        signalHandler();

        await vi.waitFor(() => {
          expect(stopProxyMock).toHaveBeenCalledWith(handle);
        });
        expect(exitSpy).not.toHaveBeenCalled();
        if (!finishCompanionCleanup) {
          throw new Error("companion signal cleanup did not start");
        }
        finishCompanionCleanup();
        await vi.waitFor(() => expect(captureFinalizer).toHaveBeenCalledOnce());
        expect(exitSpy).not.toHaveBeenCalled();
        expect(retireWorkerSource).not.toHaveBeenCalled();
        captureFinished.resolve();
        await vi.waitFor(() => {
          expect(exitSpy).toHaveBeenCalledWith(exitCode);
        });
        expect(cleanupOrder).toEqual(["capture", "worker-source"]);

        resolveRoute(true);
        await runPromise;
        expect(stopProxyMock).toHaveBeenCalledTimes(1);
        expect(captureFinalizer).toHaveBeenCalledOnce();
      } finally {
        captureFinished.resolve();
        finishCompanionCleanup?.();
        resolveRoute(true);
        try {
          await runPromise;
        } finally {
          unregisterCompanionCleanup();
          unregisterCapture();
          unregisterWorkerSource();
          await waitForSignalExitBarriers();
          exitSpy.mockRestore();
          processOnceSpy.mockRestore();
        }
      }
    },
  );

  it("keeps the original signal proxy stop pending through bounded command cleanup", async () => {
    const handle = makeProxyHandle();
    const route = createDeferredCore<boolean>();
    const stopping = createDeferredCore();
    const resume = createDeferredCore();
    startProxyMock.mockResolvedValueOnce(handle);
    tryRouteCliMock.mockReturnValueOnce(route.promise);
    stopProxyMock.mockImplementationOnce(async () => {
      stopping.resolve();
      await resume.promise;
    });
    const running = runCli(["node", "openclaw", "plugins", "marketplace", "list"]);
    let barrier: Promise<void> | undefined;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await vi.waitFor(() => expect(tryRouteCliMock).toHaveBeenCalled());
      barrier = waitForSignalExitBarriers();
      await stopping.promise;
      vi.useFakeTimers();
      route.resolve(true);
      await vi.waitFor(() => expect(getPendingCliDisposers()).toContain("managed-proxy"));
      await vi.advanceTimersByTimeAsync(5_000);
      await running;
      expect(getPendingCliDisposers()).toContain("managed-proxy");
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("managed-proxy"));
      expect(stopProxyMock).toHaveBeenCalledExactlyOnceWith(handle);
    } finally {
      route.resolve(true);
      resume.resolve();
      vi.useRealTimers();
      await barrier;
      await running;
      stderr.mockRestore();
    }
    expect(getPendingCliDisposers()).not.toContain("managed-proxy");
  });

  it("synchronously kills the managed proxy during hard process exit", async () => {
    const handle = makeProxyHandle();
    startProxyMock.mockResolvedValueOnce(handle);
    let resolveRoute: (value: boolean) => void = () => {};
    tryRouteCliMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveRoute = resolve;
      }),
    );

    const processOnceSpy = vi.spyOn(process, "once");
    try {
      const runPromise = runCli(["node", "openclaw", "plugins", "marketplace", "list"]);
      await vi.waitFor(() => {
        expect(
          processOnceSpy.mock.calls.reduce(
            (count, [event]) => count + (event === "exit" ? 1 : 0),
            0,
          ),
        ).toBe(1);
      });

      const exitHandler = processOnceSpy.mock.calls.find(([event]) => event === "exit")?.[1];
      if (typeof exitHandler !== "function") {
        throw new Error("exit handler was not registered");
      }
      exitHandler(0 as never);

      expect(handle.kill).toHaveBeenCalledWith("SIGTERM");
      resolveRoute(true);
      await runPromise;
      expect(stopProxyMock).not.toHaveBeenCalledWith(handle);
    } finally {
      processOnceSpy.mockRestore();
    }
  });
}

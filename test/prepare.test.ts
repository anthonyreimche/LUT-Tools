// Preparing files off the window's thread: the worker gets each file's bytes
// and hands back the packed LUT; where the worker can't start or fails, the
// files are prepared here, with the window given a turn between them.

import { describe, expect, it, vi } from "vitest";
import { writeCube } from "../src/cube";
import { cubeFrom } from "../src/lut";
import { inlinePreparer, prepareLutFile, workerPreparer, type PrepareRequest, type Prepared, type WorkerLike } from "../src/prepare";

const noJpeg = () => Promise.reject(new Error("no JPEG here"));
const cube = (gain: number, size = 5): Uint8Array =>
  new TextEncoder().encode(writeCube({ title: "t", shaper: null, cube: cubeFrom(size, (r, g, b) => [r * gain, g, b]) }));

/** A worker that answers each request the way prepare-worker.ts does, on cue. */
function fakeWorker() {
  const requests: { message: PrepareRequest; transfer: Transferable[] }[] = [];
  let terminated = false;
  const worker: WorkerLike = {
    postMessage: (message, transfer) => void requests.push({ message, transfer }),
    onmessage: null,
    onerror: null,
    terminate: () => void (terminated = true),
  };
  return {
    worker,
    requests,
    terminated: () => terminated,
    async answer(i: number): Promise<void> {
      const { id, name, bytes } = requests[i].message;
      const result = await prepareLutFile(name, bytes, noJpeg);
      worker.onmessage?.(new MessageEvent("message", { data: { id, result } }));
    },
    fail: () => worker.onerror?.(new ErrorEvent("error")),
  };
}

describe("preparing in a worker", () => {
  it("starts the worker on the first file, sends it a copy of the bytes to keep, and takes its answer", async () => {
    const fake = fakeWorker();
    let starts = 0;
    const prepare = workerPreparer(() => {
      starts++;
      return fake.worker;
    }, inlinePreparer(noJpeg));
    expect(starts).toBe(0);
    const bytes = cube(0.9);
    const pending = prepare("a.cube", bytes);
    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0];
    expect(sent.message.bytes).not.toBe(bytes);
    expect(sent.transfer).toEqual([sent.message.bytes.buffer]);
    expect(bytes.byteLength).toBeGreaterThan(0);
    await fake.answer(0);
    const result = await pending;
    expect(result).toEqual(await prepareLutFile("a.cube", bytes, noJpeg));
    void prepare("b.cube", cube(0.8));
    expect(starts).toBe(1);
  });

  it("prepares the files the worker had, and every later one, here when it fails", async () => {
    const fake = fakeWorker();
    const prepare = workerPreparer(() => fake.worker, inlinePreparer(noJpeg));
    const a = prepare("a.cube", cube(0.9));
    const b = prepare("b.cube", cube(0.8));
    fake.fail();
    expect(fake.terminated()).toBe(true);
    const results: Prepared[] = [await a, await b, await prepare("c.cube", cube(0.7))];
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(fake.requests).toHaveLength(2);
  });

  it("ends the worker on dispose, preparing here what it still had", async () => {
    const fake = fakeWorker();
    const prepare = workerPreparer(() => fake.worker, inlinePreparer(noJpeg));
    const pending = prepare("a.cube", cube(0.9));
    prepare.dispose();
    expect(fake.terminated()).toBe(true);
    expect((await pending).ok).toBe(true);
  });

  it("prepares here when the worker can't start", async () => {
    const prepare = workerPreparer(() => {
      throw new Error("no workers here");
    }, inlinePreparer(noJpeg));
    expect((await prepare("a.cube", cube(0.9))).ok).toBe(true);
  });
});

describe("preparing on the window's thread", () => {
  // The digest is stubbed to settle at once: the real one may yield by itself.
  it("gives the window a turn between files once a slice's time is used", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async () => new ArrayBuffer(32));
    try {
      const prepare = inlinePreparer(noJpeg);
      let ticked = false;
      setTimeout(() => (ticked = true), 0);
      for (let i = 0; i < 4; i++) await prepare(`${i}.cube`, cube(1 - i / 10, 33));
      expect(ticked).toBe(true);
    } finally {
      digest.mockRestore();
    }
  });
});

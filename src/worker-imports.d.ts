// Vite's inline worker import: the module's default export starts the worker.
declare module "*?worker&inline" {
  const WorkerFactory: new (options?: { name?: string }) => Worker;
  export default WorkerFactory;
}

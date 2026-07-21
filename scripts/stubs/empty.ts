/** Stub for optional native packages excluded from the standalone binary. */
export default {};
export const initialize = () => {};
export const connectToDevTools = () => {};
export const env = {
  cacheDir: "",
  allowLocalModels: true,
  allowRemoteModels: true,
};
export async function pipeline(): Promise<never> {
  throw new Error(
    "Local Transformers.js / ONNX embeddings are not bundled in the standalone binary. Set embeddings.provider to openai, or run via `bun run localdoc`.",
  );
}

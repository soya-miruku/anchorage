/**
 * Reads a picked file as base64, which is how uploads cross the JSON transport.
 *
 * `File.arrayBuffer()` is the direct route and is what Electron provides, but it is not
 * implemented everywhere — notably not in the jsdom environment the renderer tests run in,
 * which is why both upload paths were previously untestable and therefore untested. Falling
 * back to FileReader keeps one code path for the application and makes it exercisable.
 */
export async function readFileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await readFileBytes(file));
  // Chunked so a large file cannot blow the argument limit of String.fromCharCode.
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return window.btoa(binary);
}

function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("The file could not be read"));
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
        return;
      }
      reject(new Error("The file could not be read as bytes"));
    };
    reader.readAsArrayBuffer(file);
  });
}

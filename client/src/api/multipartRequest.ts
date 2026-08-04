/**
 * The shared apiV2 instance sets `Content-Type: application/json` as an instance-wide default.
 * Axios checks that header while serializing the body: when it sees a JSON content type it converts
 * a FormData payload into a JSON object rather than sending multipart. The gateway's multipart
 * parser then finds no file and the request fails with "Failed to upload file".
 *
 * Every FormData post through apiV2 must therefore override the instance default. Existing upload
 * call sites inline this header; exporting it keeps the reason documented in one place instead of
 * relying on each caller remembering why the header is required.
 */
export function multipartRequestConfig(): { headers: Record<string, string> } {
    return { headers: { 'Content-Type': 'multipart/form-data' } };
}

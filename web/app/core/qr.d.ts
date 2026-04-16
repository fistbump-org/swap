/**
 * Produce a data URL (PNG) encoding `text` as a QR code. Uses a modest
 * pixel size (256×256) with a white background and quiet zone suitable
 * for phone-camera capture.
 *
 * Blobs can run 500–1200 chars, which is within QR capacity at H-level
 * error correction. We use M-level (medium) as a balance: still scannable
 * on a typical phone held 20–30 cm away, but allows more data per QR.
 */
export declare function blobQrDataUrl(text: string): Promise<string | null>;
//# sourceMappingURL=qr.d.ts.map
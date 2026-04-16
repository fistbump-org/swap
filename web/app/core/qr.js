// QR code generation for blob envelopes.
//
// Wraps the `qrcode` npm package so the app layer can ask for a
// data-URL-encoded PNG without importing qrcode directly (it stays inside
// the bundle, not in the importmap). Errors are swallowed into a null
// return — QR display is a nice-to-have, not critical; the copy button
// always works even if QR rendering fails.
import QRCode from "qrcode";
/**
 * Produce a data URL (PNG) encoding `text` as a QR code. Uses a modest
 * pixel size (256×256) with a white background and quiet zone suitable
 * for phone-camera capture.
 *
 * Blobs can run 500–1200 chars, which is within QR capacity at H-level
 * error correction. We use M-level (medium) as a balance: still scannable
 * on a typical phone held 20–30 cm away, but allows more data per QR.
 */
export async function blobQrDataUrl(text) {
    try {
        return await QRCode.toDataURL(text, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 256,
            color: {
                dark: "#000000",
                light: "#ffffff",
            },
        });
    }
    catch (err) {
        console.warn("blobQrDataUrl failed:", err);
        return null;
    }
}
//# sourceMappingURL=qr.js.map
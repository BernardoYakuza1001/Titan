package io.titan.pos.hal.tokenizer

/**
 * PROJECT TITAN — Hardware/PSP-agnostic CARD CAPTURE boundary (HAL).
 *
 * Vendor implementations (PAX SPoC, SUNMI, Ingenico) or the PSP's certified
 * card-input component sit behind this interface. They capture the card INSIDE
 * their PCI-validated component and return a single-use [PaymentToken].
 *
 * DESIGN RULE — NON-NEGOTIABLE:
 *   Raw PAN / Expiry-as-secret / CVV NEVER cross this interface and never enter
 *   the Titan application process or heap. There is deliberately NO method here
 *   that accepts or returns a PAN or a CVV. (This replaces a raw "ICardDataCapture":
 *   keying PAN+CVV into app-owned byte[] would place the whole APK in PCI SAQ-D +
 *   SPoC/CPoC/MPoC certification scope, and zeroing the buffers does not change
 *   that. Tokenize at capture instead.)
 *
 * The implementing SDK is responsible, inside its certified boundary, for secure
 * keypad/entry, encryption, and memory hygiene of the cardholder data.
 */
interface ICardTokenizer {

    /** Keyed / MOTO ("Venda Digitada") entry via the certified secure-entry field. */
    suspend fun captureManualEntry(request: CaptureRequest): CaptureResult

    /** Card-present contactless (NFC) capture via the certified reader. */
    suspend fun captureContactless(request: CaptureRequest): CaptureResult

    /** Abort an in-flight capture and release the certified component. */
    fun cancel()
}

/**
 * Context the certified component needs to render the entry flow and bind the
 * resulting token to this exact sale. No card data here — only the amount and
 * the idempotency token.
 */
data class CaptureRequest(
    val amountMinor: Long,
    val currency: String,
    /** POS-minted idempotency key; echoed to the backend with the token. */
    val correlationToken: String,
)

/** Outcome of a capture. The success case carries ONLY a token + masked metadata. */
sealed interface CaptureResult {
    data class Tokenized(val token: PaymentToken) : CaptureResult
    data class Cancelled(val reason: String) : CaptureResult
    /** Capture-side failure (reader error, entry timeout) — distinct from a decline. */
    data class Failed(val code: String, val message: String) : CaptureResult
}

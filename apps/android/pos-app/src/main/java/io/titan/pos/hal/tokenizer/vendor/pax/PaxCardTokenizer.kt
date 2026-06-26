package io.titan.pos.hal.tokenizer.vendor.pax

import io.titan.pos.hal.tokenizer.CaptureRequest
import io.titan.pos.hal.tokenizer.CaptureResult
import io.titan.pos.hal.tokenizer.ICardTokenizer

/**
 * PAX implementation of the vendor-agnostic [ICardTokenizer] HAL.
 *
 * Orchestrates: certified secure capture (PAX) -> tokenize the encrypted payload
 * (Viva) -> return a single-use [io.titan.pos.hal.tokenizer.PaymentToken]. The
 * plaintext PAN/CVV NEVER leave PAX's secure processor; this class only ever
 * touches the P2PE ciphertext (which it wipes) and the resulting token.
 */
class PaxCardTokenizer(
    private val reader: PaxSecureCardReader,
    private val tokenization: VivaTokenization,
) : ICardTokenizer {

    override suspend fun captureManualEntry(request: CaptureRequest): CaptureResult =
        capture(request) { reader.captureManualEntry(request.amountMinor, request.currency) }

    override suspend fun captureContactless(request: CaptureRequest): CaptureResult =
        capture(request) { reader.captureContactless(request.amountMinor, request.currency) }

    private suspend fun capture(request: CaptureRequest, read: () -> PaxCaptureOutcome): CaptureResult {
        val outcome = try {
            read()
        } catch (e: Exception) {
            return CaptureResult.Failed("READER_ERROR", e.message ?: "PAX capture failed")
        }

        val encrypted = when (outcome) {
            is PaxCaptureOutcome.Captured -> outcome.card
            is PaxCaptureOutcome.Cancelled -> return CaptureResult.Cancelled(outcome.reason)
            is PaxCaptureOutcome.Failed -> return CaptureResult.Failed(outcome.code, outcome.message)
        }

        return try {
            val token = tokenization.tokenize(encrypted, request.correlationToken)
            CaptureResult.Tokenized(token)
        } catch (e: Exception) {
            CaptureResult.Failed("TOKENIZATION_FAILED", e.message ?: "Viva tokenization failed")
        } finally {
            // The ciphertext has served its purpose — zero it immediately.
            encrypted.wipe()
        }
    }

    override fun cancel() = reader.cancel()
}

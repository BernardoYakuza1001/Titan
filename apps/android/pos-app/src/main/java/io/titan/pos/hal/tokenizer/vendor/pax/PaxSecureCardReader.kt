package io.titan.pos.hal.tokenizer.vendor.pax

import io.titan.pos.hal.tokenizer.CardBrand

/**
 * The CERTIFIED PAX secure-entry boundary. Card capture (manual keyed entry on
 * the secure PED, or contactless) AND encryption happen INSIDE PAX's secure
 * processor. Only a P2PE-encrypted payload + non-sensitive display metadata cross
 * this interface — never plaintext PAN/CVV.
 */
interface PaxSecureCardReader {
    fun captureManualEntry(amountMinor: Long, currency: String): PaxCaptureOutcome
    fun captureContactless(amountMinor: Long, currency: String): PaxCaptureOutcome
    fun cancel()
}

/**
 * Output of a secure capture: the DUKPT/P2PE ciphertext (opaque to app code) plus
 * the safe-to-display fields the SE is allowed to reveal. The plaintext PAN/CVV
 * stay inside the secure processor and are encrypted there.
 */
class PaxEncryptedCard(
    val encryptedPayload: ByteArray,   // P2PE ciphertext — opaque; handed to tokenization then wiped
    val ksn: String,                   // DUKPT key serial number (gateway uses it to decrypt)
    val maskedPan: String,             // "411111****1111"
    val cardBrand: CardBrand,
    val expiryMonth: Int,
    val expiryYear: Int,
) {
    /** Zero the ciphertext buffer the instant tokenization no longer needs it. */
    fun wipe() {
        encryptedPayload.fill(0)
    }
}

sealed interface PaxCaptureOutcome {
    data class Captured(val card: PaxEncryptedCard) : PaxCaptureOutcome
    data class Cancelled(val reason: String) : PaxCaptureOutcome
    data class Failed(val code: String, val message: String) : PaxCaptureOutcome
}

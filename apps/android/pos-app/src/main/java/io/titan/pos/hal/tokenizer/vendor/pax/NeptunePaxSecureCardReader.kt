package io.titan.pos.hal.tokenizer.vendor.pax

import io.titan.pos.hal.tokenizer.CardBrand

/**
 * Minimal facade over PAX's Neptune Lite API (`com.pax.dal.*`). This is the ONE
 * place that touches the proprietary PAX SDK; everything else in the tokenizer
 * stack is vendor-agnostic and unit-testable.
 *
 * A real implementation (`NeptunePaxDal`, the only class that imports `com.pax.*`)
 * performs, entirely inside the secure processor:
 *   1. `IDAL dal = NeptuneLiteUser.getInstance().getDal(context)`
 *   2. secure entry: `dal.getPed(EPedType.INTERNAL).inputText(...)` with the
 *      secure-keyboard flag for the PAN (and CVV / expiry) — the plaintext is
 *      held in the SE, never returned to the app.
 *   3. DUKPT/P2PE encrypt under the injected key (`IPed.getPinBlock` / `calcMac`
 *      / vendor P2PE call), yielding ciphertext + KSN.
 *   4. derive the MASKED pan + brand for display.
 * It returns a [PaxDalResult]; the plaintext PAN/CVV never cross this boundary.
 */
interface PaxDal {
    fun secureManualEntryAndEncrypt(amountMinor: Long, currency: String): PaxDalResult
    fun secureContactlessAndEncrypt(amountMinor: Long, currency: String): PaxDalResult
    fun cancel()
}

enum class PaxDalStatus { OK, CANCELLED, TIMEOUT, ERROR }

/** What the secure element returns — ciphertext + KSN + masked display only. */
data class PaxDalResult(
    val status: PaxDalStatus,
    val encryptedPayload: ByteArray? = null,
    val ksn: String? = null,
    val maskedPan: String? = null,
    val brand: String? = null,
    val expiryMonth: Int = 0,
    val expiryYear: Int = 0,
    val message: String? = null,
)

/**
 * Vendor-agnostic [PaxSecureCardReader] over a [PaxDal]. Pure mapping logic — no
 * PAX imports — so it is fully testable with a fake PaxDal.
 */
class NeptunePaxSecureCardReader(private val dal: PaxDal) : PaxSecureCardReader {

    override fun captureManualEntry(amountMinor: Long, currency: String): PaxCaptureOutcome =
        toOutcome(dal.secureManualEntryAndEncrypt(amountMinor, currency))

    override fun captureContactless(amountMinor: Long, currency: String): PaxCaptureOutcome =
        toOutcome(dal.secureContactlessAndEncrypt(amountMinor, currency))

    override fun cancel() = dal.cancel()

    private fun toOutcome(r: PaxDalResult): PaxCaptureOutcome = when (r.status) {
        PaxDalStatus.OK -> {
            val payload = r.encryptedPayload
            if (payload == null || r.ksn == null || r.maskedPan == null) {
                PaxCaptureOutcome.Failed("SE_INCOMPLETE", "secure element returned no ciphertext")
            } else {
                PaxCaptureOutcome.Captured(
                    PaxEncryptedCard(
                        encryptedPayload = payload,
                        ksn = r.ksn,
                        maskedPan = r.maskedPan,
                        cardBrand = brandOf(r.brand),
                        expiryMonth = r.expiryMonth,
                        expiryYear = r.expiryYear,
                    ),
                )
            }
        }
        PaxDalStatus.CANCELLED -> PaxCaptureOutcome.Cancelled(r.message ?: "cancelled by operator")
        PaxDalStatus.TIMEOUT -> PaxCaptureOutcome.Failed("TIMEOUT", r.message ?: "card entry timed out")
        PaxDalStatus.ERROR -> PaxCaptureOutcome.Failed("READER_ERROR", r.message ?: "PAX reader error")
    }

    private fun brandOf(s: String?): CardBrand = when (s?.uppercase()) {
        "VISA" -> CardBrand.VISA
        "MASTERCARD", "MC" -> CardBrand.MASTERCARD
        "AMEX", "AMERICAN EXPRESS" -> CardBrand.AMEX
        "DISCOVER" -> CardBrand.DISCOVER
        "DINERS", "DINERS CLUB" -> CardBrand.DINERS
        "JCB" -> CardBrand.JCB
        "UNIONPAY", "CUP" -> CardBrand.UNIONPAY
        else -> CardBrand.UNKNOWN
    }
}

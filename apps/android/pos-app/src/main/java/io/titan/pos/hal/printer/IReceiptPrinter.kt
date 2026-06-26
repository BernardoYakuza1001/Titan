package io.titan.pos.hal.printer

/**
 * PROJECT TITAN — Hardware-agnostic thermal printer (HAL).
 *
 * Vendor implementations (PAX, SUNMI, Ingenico) format and drive the terminal's
 * thermal head behind this interface. Receipts carry ONLY the masked PAN and the
 * acquirer confirmation payload — never the full PAN, and never the CVV (CVV must
 * never be printed, displayed, or stored, per PCI-DSS / card-scheme rules).
 *
 * The stateless POS fetches the data for [printReprint] from the backend
 * `/api/v1/terminal/history` endpoint, so reprints work without any local state.
 */
interface IReceiptPrinter {

    /** Print the merchant + cardholder copy for a freshly completed sale. */
    suspend fun printSaleReceipt(receipt: SaleReceipt): PrintResult

    /** Re-print an historical sale (data sourced from the backend ledger). */
    suspend fun printReprint(receipt: SaleReceipt): PrintResult

    /** Cheap pre-check so the app can warn before attempting to print. */
    fun isPaperPresent(): Boolean
}

/**
 * Everything needed to render a receipt. All fields are non-sensitive: the only
 * card reference is [maskedPan].
 */
data class SaleReceipt(
    val merchantName: String,
    val terminalId: String,
    val maskedPan: String,            // "411111****1111"
    val cardBrand: String,
    val amountMinor: Long,
    val currency: String,
    /** FIAT_APPROVED / FIAT_DECLINED, mirrored from the ledger. */
    val status: String,
    val authorizationCode: String?,   // present on approval
    val vivaOrderCode: String?,
    val vivaTransactionId: String?,
    val timestampIso: String,
    val correlationToken: String,
    val isReprint: Boolean,
)

sealed interface PrintResult {
    data object Success : PrintResult
    /** OUT_OF_PAPER, HEAD_OVERHEAT, HARDWARE_FAULT, … */
    data class Failed(val code: String, val message: String) : PrintResult
}

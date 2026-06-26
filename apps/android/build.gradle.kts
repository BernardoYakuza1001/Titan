// Root build script — plugin versions declared once, applied in the module.
// Version matrix chosen for known compatibility: AGP 8.5.2 + Kotlin 1.9.24 +
// Gradle 8.7 + JDK 17 + compileSdk 34. Bump together if you upgrade.
plugins {
    id("com.android.application") version "8.5.2" apply false
}

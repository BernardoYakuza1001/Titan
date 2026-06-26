plugins {
    id("com.android.application")
}

// Framework-only Java app (no Kotlin, no AndroidX, no AAR dependencies). Builds
// with the standard Android toolchain alone — the same way it is built
// Gradle-free in build-apk.ps1 (aapt2 -> javac -> d8 -> apksigner). The MoonPay
// widget is opened via a plain WebView (MoonPay's documented URL integration),
// so no MoonPay AAR / dependency resolution is required.
android {
    namespace = "io.titan.pos"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.titan.pos"
        minSdk = 30          // Android 11+ per blueprint Phase 2
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        getByName("debug") { isMinifyEnabled = false }
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

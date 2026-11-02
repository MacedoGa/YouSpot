plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// No GitHub Actions cada build ganha um número maior (o Android só instala por cima versões maiores).
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "app.youspot.ponte"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.youspot.ponte"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "0.1.$buildNumber"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Cliente Socket.IO 2.x conversa com servidor Socket.IO v4 (Engine.IO 4).
    implementation("io.socket:socket.io-client:2.1.1") {
        exclude(group = "org.json", module = "json") // o Android já tem org.json
    }
}

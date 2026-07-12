plugins {
    kotlin("jvm") version "2.4.0"
    application
}

group = "com.phemex"
version = "1.0.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.json:json:20250107")
}

application {
    mainClass = "MainKt"
}

tasks.jar {
    manifest {
        attributes["Main-Class"] = "MainKt"
    }
}

kotlin {
    jvmToolchain {
        languageVersion = JavaLanguageVersion.of(26)
    }
}
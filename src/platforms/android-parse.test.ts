import { assert, test } from 'orca/testing'
import { extractBuildErrors } from './ios-parse'
import {
  adbTransport,
  avdApiLevel,
  isAppModule,
  parseAdbDevices,
  parseIncludedModules,
  parseVariants,
  preferredAndroidDestination,
  summarizeAndroidCrash,
  variantTask
} from './android-parse'

test('adb devices: emulators, USB and Wi-Fi phones, unauthorized ones', () => {
  const text = `List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:5
R5CT1234ABC            device usb:1-1 product:o1s model:SM_G991B device:o1s transport_id:2
192.168.1.20:41235     device product:panther model:Pixel_7 device:panther transport_id:7
adb-29031FDH-abc._adb-tls-connect._tcp device product:husky model:Pixel_8_Pro transport_id:9
ZY22XYZ                unauthorized usb:1-2 transport_id:3
`
  assert.deepEqual(parseAdbDevices(text), [
    { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 arm64' },
    { serial: 'R5CT1234ABC', state: 'device', model: 'SM G991B' },
    { serial: '192.168.1.20:41235', state: 'device', model: 'Pixel 7' },
    { serial: 'adb-29031FDH-abc._adb-tls-connect._tcp', state: 'device', model: 'Pixel 8 Pro' },
    { serial: 'ZY22XYZ', state: 'unauthorized' }
  ])
  assert.equal(adbTransport('R5CT1234ABC'), 'cable')
  assert.equal(adbTransport('192.168.1.20:41235'), 'wifi')
  assert.equal(adbTransport('adb-29031FDH-abc._adb-tls-connect._tcp'), 'wifi')
  assert.equal(avdApiLevel('image.sysdir.1=system-images/android-36/google_apis_playstore/arm64-v8a/\n'), '36')
})

test('Gradle: included modules, app modules and variants (Kotlin and Groovy DSL)', () => {
  assert.deepEqual(parseIncludedModules('include(":app")\ninclude(":waiter", ":api")\ninclude \':core\'\n// include(":old")\n'), [':app', ':waiter', ':api', ':core'])
  assert.ok(isAppModule('plugins {\n    alias(libs.plugins.android.application)\n}'))
  assert.ok(isAppModule("apply plugin: 'com.android.application'"))
  assert.ok(!isAppModule('plugins { id("com.android.library") }'))
  const kts = `android {
    buildTypes {
        release { isMinifyEnabled = true }
        create("internal") {
            initWith(getByName("release"))
            applicationIdSuffix = ".internal"
        }
    }
}`
  assert.deepEqual(parseVariants(kts), ['debug', 'release', 'internal'])
  const groovy = `android {
  buildTypes {
    release { minifyEnabled true }
    staging { initWith debug }
  }
  flavorDimensions "tier"
  productFlavors {
    free { dimension "tier" }
    paid { dimension "tier" }
  }
}`
  assert.deepEqual(parseVariants(groovy), ['freeDebug', 'freeRelease', 'freeStaging', 'paidDebug', 'paidRelease', 'paidStaging'])
  assert.equal(variantTask('freeDebug'), 'FreeDebug')
})

test('default Android destination: running emulator, connected phone, then any emulator', () => {
  const base = { platform: 'android' as const, os: '16' }
  const avd = { ...base, kind: 'simulator' as const, udid: 'stock_caps', name: 'stock caps', state: 'shutdown' as const }
  const phone = { ...base, kind: 'device' as const, udid: 'R5', name: 'Pixel 7', state: 'connected' as const }
  const running = { ...avd, udid: 'play_screens', name: 'play screens', state: 'booted' as const }
  const iosSim = { ...running, platform: 'ios' as const }
  assert.equal(preferredAndroidDestination([iosSim, avd, phone, running])?.udid, 'play_screens')
  assert.equal(preferredAndroidDestination([avd, phone])?.udid, 'R5')
  assert.equal(preferredAndroidDestination([iosSim, avd])?.udid, 'stock_caps')
})

test('crash buffer and Gradle failures read like the iOS ones', () => {
  const crash = `--------- beginning of crash
11-25 12:40:01.123  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main
11-25 12:40:01.123  4321  4321 E AndroidRuntime: Process: com.qamarero.waiter, PID: 4321
11-25 12:40:01.123  4321  4321 E AndroidRuntime: java.lang.IllegalStateException: Menu not loaded
11-25 12:40:01.123  4321  4321 E AndroidRuntime: \tat com.qamarero.waiter.MenuCatalog.load(MenuCatalog.kt:42)
`
  const { title, summary } = summarizeAndroidCrash(crash)
  assert.equal(title, 'java.lang.IllegalStateException: Menu not loaded')
  assert.match(summary, /^FATAL EXCEPTION: main\nProcess: com\.qamarero\.waiter/)
  const log = `> Task :app:preBuild UP-TO-DATE
> Task :waiter:compileDebugKotlin FAILED
e: file:///Users/me/w/android/waiter/src/main/kotlin/MenuCatalog.kt:42:13 Unresolved reference 'subcategory'.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':waiter:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
`
  assert.deepEqual(extractBuildErrors(log), [
    '> Task :waiter:compileDebugKotlin FAILED',
    "e: MenuCatalog.kt:42:13 Unresolved reference 'subcategory'.",
    'FAILURE: Build failed with an exception.',
    '> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction'
  ])
})

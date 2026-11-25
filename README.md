# Mobile Launchpad

Plugin de [Orca](https://github.com/stablyai/orca) para hacer **Build & Run de la app móvil del worktree
activo** en un simulador de iOS o en un iPhone conectado por cable o Wi-Fi, desde el status bar. Solo
aparece en worktrees con un proyecto móvil (iOS ahora; Android, después).

- **Status bar**: `🚀 MiApp · iPhone 18 Pro`. Pulsar compila y lanza; mientras compila muestra la
  fase (`Compilando… · iPhone`), en verde cuando la app se ejecuta y en rojo si falla.
- **Panel "Mobile Launchpad"** (barra lateral derecha): proyecto, scheme, configuración y destino de cada
  worktree. Cada worktree recuerda su configuración.
- **Simulador por worktree**: "Crear simulador «<worktree> iPhone»" clona el modelo y la versión de
  iOS del simulador seleccionado, para probar varias ramas a la vez sin pisarse.
- **Paleta**: `Mobile Launchpad: Build & Run` (`Mod+Alt+R`) y `Mobile Launchpad: Stop`.

## Cómo funciona

El worker busca el `.xcworkspace`/`.xcodeproj` en la raíz del worktree o en una carpeta móvil
convencional (`ios/`, `iosApp/`, `apple/`, `app/`, `mobile/ios/`, `apps/ios/`…). Una carpeta que solo
contiene otros repos no cuenta y, al lanzar, abre una terminal de Orca en ese worktree que ejecuta un script:

1. Simulador: `simctl bootstatus -b` y lo muestra en el panel de emulador de Orca (`orca emulator attach`), o en Simulator.app si está instalado.
2. `xcodebuild build` (con `xcbeautify` si está instalado; si no, `-quiet`). En dispositivo añade
   `-allowProvisioningUpdates`. Usa el DerivedData por defecto de Xcode, así que comparte caché
   con Xcode.
3. Instala y lanza con la consola de la app en la terminal:
   - Simulador: `simctl install` + `simctl launch --console-pty`.
   - iPhone: `devicectl device install app` + `devicectl device process launch --console`.

El script escribe su fase en un fichero de estado que el worker lee cada segundo para actualizar el
status bar. Ctrl-C en la terminal (o `Stop`) para la app. Relanzar cierra la terminal anterior.

## Desarrollo

```sh
npm install            # TypeScript y tipos de Node, solo para `npm run typecheck`
npm run typecheck
orca plugin test . --json
orca plugin check . --json
orca plugin dev watch . --check --json   # carga el plugin en Orca y recarga al guardar
```

Estructura:

- `src/worker.ts`: estado por worktree, status bar, comandos y peticiones del panel.
- `src/panel.tsx`: el panel (componentes de Orca, sin build).
- `src/platforms/ios.ts`: adaptador de iOS (proyectos, schemes, dispositivos, script de run).
- `src/platforms/ios-parse.ts`: parsers puros de `simctl`, `devicectl` y `xcodebuild -list`.

## Android (siguiente paso)

La lógica de plataforma vive en `src/platforms/`. Un adaptador `android.ts` ofrecería lo mismo:
detectar `gradlew` + `settings.gradle(.kts)`, listar con `adb devices -l` y `emulator -list-avds`
(Wi-Fi con `adb pair`/`adb connect`) y lanzar con `./gradlew :app:installDebug` + `adb shell am
start`. Falta añadir `'android'` a `Platform` y que el worker elija adaptador según el proyecto.

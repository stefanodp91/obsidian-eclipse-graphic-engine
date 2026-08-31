# Capacitor adapter documentation

The `obsidian-eclipse-capacitor-plugins` package connects the engine's platform-neutral
`NativeServices` port to Capacitor 8 and to browser fallbacks.

## Guides

- [Architecture](architecture.md) explains the dependency and fallback model.
- [Installation](installation.md) covers package installation and native synchronization.
- [Native plugins](native-plugins.md) documents Android and iOS registration and parity.
- [Power and thermal signals](power-and-thermal.md) defines platform behavior and limitations.
- [Observability](observability.md) covers the optional Firebase adapter subpath.
- [Testing and release](testing-and-release.md) describes contract checks and GitHub Releases.

```mermaid
flowchart LR
    App[Capacitor application] --> Facade[NativeServices facade]
    Facade --> Plugins[Bundled native plugins]
    Facade --> Official[Capacitor ecosystem plugins]
    Facade --> Browser[Browser fallbacks]
    Plugins --> Android[Android APIs]
    Plugins --> IOS[iOS APIs]
```

This wiki documents the reusable package only. Application signing, store deployment, Firebase
projects, analytics taxonomies, and product build pipelines belong to the consuming application.

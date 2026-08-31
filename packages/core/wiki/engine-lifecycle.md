# Engine lifecycle

The facade is created after a rendering scene exists. The caller injects observable state and
resource services, then retains ownership of the underlying renderer.

```mermaid
stateDiagram-v2
    [*] --> Constructed: createGraphicEngine
    Constructed --> Active: phase.transition(Active)
    Active --> Reduced: phase.transition(Reduced)
    Reduced --> Active: phase.transition(Active)
    Active --> Halted: phase.transition(Halted)
    Reduced --> Halted: phase.transition(Halted)
    Halted --> Active: phase.transition(Active)
    Constructed --> Disposed: dispose
    Active --> Disposed: dispose
    Reduced --> Disposed: dispose
    Halted --> Disposed: dispose
    Disposed --> Disposed: dispose is idempotent
```

`EnginePhase` deliberately has only three rendering states:

| Phase | Intended rendering state | Intended physics state |
| --- | --- | --- |
| `Active` | running | running |
| `Reduced` | running | paused or reduced by the host |
| `Halted` | stopped | stopped |

The host maps its own screens and gameplay states onto these values. The core never imports a host
state machine.

## Construction rules

- `keyPrefix` is mandatory and namespaces persisted state.
- `rendering.scene` must reference an existing scene-like object.
- the quality port is required;
- tier, phase source, frame registration, resources, and input are optional;
- missing optional ports use neutral no-op behavior.

## Disposal

`dispose()` is idempotent and invokes the host-provided `onDispose` callback once. Writes after
disposal throw because they would mutate torn-down state. Read subscriptions remain callable during
framework teardown.

The facade does not automatically dispose the adopted scene, Babylon engine, React root, or native
bridge. The component that created each resource must destroy it.

import "./environment"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { Project } from "../../../src/project/project"

for (const mode of ["load", "reload", "overlapping-reload"])
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let block = false
      const layer = LayerNode.compile(InstanceStore.node, [
        [Project.node, Layer.mock(Project.Service, {})],
        [
          InstanceStore.bootstrapNode,
          Layer.succeed(InstanceBootstrap.Service, {
            run: Effect.suspend(() =>
              block ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void,
            ),
          }),
        ],
      ])
      const scope = yield* Scope.make()
      const services = yield* Layer.buildWithScope(layer, scope)
      const store = Context.get(services, InstanceStore.Service)
      const input = {
        directory: process.cwd(),
        worktree: process.cwd(),
        project: {
          id: ProjectV2.ID.global,
          worktree: process.cwd(),
          sandboxes: [],
          time: { created: 0, updated: 0 },
        },
      }
      if (mode === "reload") yield* store.load(input)
      block = true
      const load = yield* (mode === "reload" ? store.reload(input) : store.load(input)).pipe(Effect.forkIn(scope))
      yield* Deferred.await(started)
      const reload =
        mode === "overlapping-reload"
          ? yield* store.reload(input).pipe(Effect.forkIn(scope, { startImmediately: true }))
          : undefined
      console.log("bootstrap started", mode)
      yield* Scope.close(scope, Exit.void)
      if (Exit.isSuccess(yield* Fiber.await(load))) throw new Error("interrupted load unexpectedly succeeded")
      if (reload && Exit.isSuccess(yield* Fiber.await(reload)))
        throw new Error("interrupted reload unexpectedly succeeded")
      console.log("instance shutdown passed")
    }),
  )
process.exit(0)

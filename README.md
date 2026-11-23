# chaos-monkey-tiny

A tiny Chaos Monkey for local Docker Compose stacks. On a schedule it picks one container that has opted in, kills it, then watches health checks to measure whether the service recovers on its own and how long that takes. Every experiment produces a Markdown report with a verdict.

## Why this exists

This project is a small-scale build of the system described in the Netflix Tech Blog post ["The Netflix Simian Army"](https://netflixtechblog.com/the-netflix-simian-army-16e57fbab116) (Yury Izrailevsky and Ariel Tseitlin, July 19, 2011). After moving to AWS, Netflix built Chaos Monkey to randomly terminate production instances during business hours, so every service had to survive losing an instance with no customer impact. The post also introduces the rest of the Simian Army: Latency Monkey, Doctor Monkey, Janitor Monkey, and Chaos Gorilla.

Clone projects (another Netflix clone, another todo app) do not teach much about how real systems fail. This one does: it breaks a real running stack and grades the result.

## How the tiny version maps to the real thing

| Netflix Simian Army | chaos-monkey-tiny |
| --- | --- |
| Chaos Monkey terminates random production instances | Kills one random opted-in container per experiment |
| Instances are expected to survive with no customer impact | Health endpoints are polled until the service is green again, and recovery time is recorded |
| Runs during business hours, when engineers are around to watch | Configurable active-hours window; experiments outside it are skipped |
| Services can opt out | Only containers labeled `chaos.enabled=true` are eligible, plus an exclude list and a probability dial |
| The point is learning what breaks before customers do | Every experiment ends in a written report: hypothesis, victim, health timeline, verdict |

What it deliberately leaves out: the rest of the Simian Army (no latency injection, no cleanup monkey, no availability-zone kills), cloud APIs, and anything multi-host. It talks to one local Docker daemon through the `docker` CLI.

## Safety model

Chaos tooling that is not safe by default is just an outage generator, so:

- **Dry run is the default.** With no flags, the monkey logs which container it would kill and kills nothing. Real kills require the explicit `--live` flag.
- **Opt-in only.** A container is eligible only if it carries the label `chaos.enabled=true`. Nothing else on the machine can be touched.
- **Blast radius of one.** Each experiment kills at most one container.
- **It cannot kill itself.** Pass `--self <container-name>` (or set `CHAOS_SELF_NAME`) and that container is excluded no matter its labels.
- **Business hours only, if you want.** Set `activeWindow` in the config and experiments outside it are skipped.
- **Probability dial.** `killProbability` lets a scheduled run sometimes spare everyone, closer to how the real monkey feels.

## Quickstart

You need Node 20+ and Docker with Compose.

```sh
npm install
npm run build
npm test
```

### Run the demo

The repo ships a demo stack with two copies of the same tiny HTTP service. The only difference is operational: `resilient-api` has a restart policy, `fragile-api` does not. Both are labeled `chaos.enabled=true`.

```sh
npm run demo:up        # build and start both demo services
npm run demo:once      # dry run: see who the monkey would kill, kill nobody
npm run demo:once:live # live: kill one container and measure recovery
npm run demo:down      # tear the stack down
```

Run the live version a few times. When the victim is `resilient-api`, Docker restarts it and the report shows a recovery in a few seconds. When the victim is `fragile-api`, nothing brings it back, the health checks stay red until the timeout, and the report records a violated hypothesis. Same code, different operations, opposite outcomes. That gap is the whole lesson of the Netflix post.

### Daemon mode

```sh
node dist/cli.js              # dry run experiments on the configured interval
node dist/cli.js --live       # same, but the kills are real
```

## Sample report

```markdown
# Chaos experiment report

- Date: 2026-11-23T21:04:05.000Z
- Mode: live
- Action: killed

## Steady-state hypothesis

Steady state: every opted-in service answers its health check. If one container
is killed, the service returns to healthy within the recovery timeout with no
manual intervention.

## Victim

- Name: chaos-monkey-tiny-resilient-api-1
- Container ID: 9f2c41ab77e0
- Image: chaos-monkey-tiny-resilient-api

## Health before the experiment

- resilient-api: healthy
- fragile-api: healthy

## Health timeline after the kill

| Time after kill | Healthy |
| --- | --- |
| 0.0s | no |
| 1.0s | no |
| 2.0s | yes |

## Recovery

Recovered in 2.0s.

## Verdict

Hypothesis held: chaos-monkey-tiny-resilient-api-1 recovered in 2.0s with no
manual intervention.
```

Reports land in `reports/` with timestamped filenames, one per experiment.

## Configuration

Everything lives in `chaos.config.json`:

| Field | Meaning |
| --- | --- |
| `labelKey` / `labelValue` | The Docker label a container must carry to be eligible (default `chaos.enabled` / `true`) |
| `killProbability` | Chance from 0 to 1 that a tick actually kills its victim |
| `intervalSeconds` | Time between experiments in daemon mode |
| `healthEndpoints` | Map of service name to health URL. Keys match a container name, its `chaos.service` label, or a substring of the container name |
| `recoveryTimeoutSeconds` | How long to wait for recovery before declaring the hypothesis violated |
| `pollIntervalSeconds` | How often health is polled during recovery |
| `activeWindow` | `{"start": "09:00", "end": "17:00"}` in local time, or `null` for no restriction |
| `excludeNames` | Container names that are never eligible |
| `reportsDir` | Where Markdown reports are written |

Bad config fails fast with every problem listed at once, not one error per run. If a victim has no matching health endpoint, the monkey falls back to watching the container state through `docker inspect`.

## Project layout

```
src/
  cli.ts        argument parsing and wiring
  config.ts     config loading and validation
  docker.ts     DockerClient interface plus the docker CLI implementation
  health.ts     HTTP health checker and recovery polling
  engine.ts     victim selection, scheduling rules, the experiment itself
  reporter.ts   Markdown report and console summary
demo/
  resilient/    demo service that recovers (restart policy in compose)
  fragile/      demo service that does not (no restart policy)
tests/          Vitest suite, runs against a fake Docker client
```

Docker access goes through a small `DockerClient` interface backed by the `docker` CLI (no Docker SDK dependency), which is what lets the test suite substitute a fake and verify things like "dry run never calls kill" without a daemon.

## What I learned

- The interesting part of chaos engineering is not the killing, it is the hypothesis. Writing down "this service should recover within 30 seconds on its own" before touching anything turns a stunt into a measurement, and the report format forces that discipline.
- Restart policies are invisible until they are the only thing that matters. The demo's two services run identical code; one passes every experiment and one fails every experiment, purely because of one line in the compose file.
- Safety defaults are a design feature. Dry run by default, opt-in labels, and a blast radius of one are what separate a chaos tool from a script that deletes production.
- Fallbacks matter at small scale too. Services without a health endpoint can still be graded on container state, which mirrors real fleets where not everything exposes `/health` yet.

## Limitations

- Local Docker only. No Kubernetes, no cloud instance termination, no multi-host fleets.
- One victim per experiment, always. No Chaos Gorilla style correlated kills.
- Recovery is judged by a single health signal (HTTP check or container state), not by real user traffic.
- The scheduler is a simple interval loop, not cron, and reports are files on disk, not a dashboard.

## What's next

The follow-up arc, each one a tiny version of another engineering blog post:

1. **A retry client that cannot cause a retry storm**, from the Amazon Builders' Library post "Timeouts, retries, and backoff with jitter": capped exponential backoff with jitter and a token-bucket retry budget, plus a simulator showing a retry storm dissolving. Safe retries are the first defense a service needs to survive the monkey.
2. **An idempotency middleware**, from Airbnb's "Avoiding double payments in a distributed payments system": idempotency keys with stored-response replay, so the retries from step 1 can never double-charge anyone.

The monkey comes first on purpose: it is the test harness the other two have to pass.

## License

MIT

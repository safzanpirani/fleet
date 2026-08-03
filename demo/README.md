# demo

`fleet-demo.gif` is generated, not recorded by hand:

```sh
vhs demo/demo.tape        # brew install vhs
```

It runs against the real fleet, but deliberately avoids `fleet ls` / `fleet
status` — those print the full host and service topology. Keep new demo steps to
generically named, reachable hosts.

# Setting up the agenvo bundle

eta keeps an agenvo relay for this bundle, as a process on the machine that runs eta, on
loopback (the bundle's `service`). It starts when the bundle is configured and `node` and
`agenvo-server` are on that machine's PATH. eta installs nothing; tell the user what to run
and wait for them to do it.

1. `agenvo-server`: build or install the agenvo server from
   <https://github.com/Xuanwo/agenvo> so that the command `agenvo-server` runs
   (`agenvo-server --help`).
2. In eta's settings → Bundles → agenvo, set the relay secret: any long random string
   (`openssl rand -hex 32`). It is stored encrypted and given only to the relay process and
   to the MCP connection, never to the shell.
3. The settings page shows the service as running once the relay answers. If it shows an
   error, its last words are there.
4. The user's remote computers pair with the relay with agenvo's own connector; the relay is
   reachable for them at eta's address under `/bundles/agenvo/service/`.

The relay's address is only valid on the machine that runs eta, so the tools exist only in
sessions there.

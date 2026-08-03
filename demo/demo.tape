# Regenerate with:  vhs demo/demo.tape     (from the repo root)
# Requires: vhs (brew install vhs), and `fleet` on PATH (bun link).
#
# Deliberately does NOT run `fleet ls` or `fleet status` — those publish the
# whole host/service topology. Keep this demo to the two reachable, generically
# named hosts.

Output demo/fleet-demo.gif

Set Shell zsh
Set FontSize 15
Set Width 1180
Set Height 780
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "PS1='%F{green}❯%f ' && clear" Enter
Show

Sleep 1s

# The whole surface, one screen.
Type "fleet --help"
Sleep 500ms
Enter
Sleep 7s

Type "clear" Enter
Sleep 500ms

# The point: one call fans out, no ssh loop, no quoting pain.
Type "fleet exec ampere,oracle 'uptime'"
Sleep 500ms
Enter
Sleep 6s

# Quoting-proof: nested quotes, $, pipes — round-trip verbatim.
Type `fleet exec ampere 'echo "nested \"quotes\", $(uname -s) & a | pipe" | tr a-z A-Z'`
Sleep 500ms
Enter
Sleep 5s

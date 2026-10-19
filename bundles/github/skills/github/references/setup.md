# Setting up GitHub

Nothing to install or paste here. The user connects GitHub in eta's settings, under “连接”: the
wizard creates a GitHub App on their account, they install it on the repositories agents may
reach, and they can authorize it so that agents act as them. `git` and `gh` must be on the
machine the session runs on (settings → Bundles shows which machine lacks which); eta installs
nothing and logs them in by itself once GitHub is connected.

Never ask the user to paste a token into the chat, and do not look for other credentials.

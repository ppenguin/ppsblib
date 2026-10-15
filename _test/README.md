# Local SilverBullet test Space

From the repository root, run:

```sh
make -C _test start
```

The Makefile creates `_test/.env` with a random `inktest` password, builds
SilverInk in its devenv, copies the repository page and all three library pages
into `_test/testspace`, and starts SilverBullet 2.12.0. Make only rebuilds the
bundle and recopies a Space file when its prerequisites have changed. The
editable Space is mounted from `_test/testspace`; notes and stroke sessions
persist across container restarts. Generated credentials and Space content are
ignored by Git. Local edits to an installed library page or bundle are
overwritten the next time its repository source changes and Make updates that
copy.

The test Space's `CONFIG` enables `sync.documents`, so SilverInk's stroke files
and SVG/PNG drawings are cached by SilverBullet for offline use. SilverBullet
syncs the plug bundle separately.
After the first online sync, reload the client and wait for its sync to finish
before testing offline.

Open `http://localhost:3001` on this host or `http://<host-LAN-IP>:3001` on
another device. Find the login in `_test/.env` (`SILVERBULLET_TEST_AUTH`).
The port binds to all host interfaces. Change `SILVERBULLET_TEST_PORT` in
`_test/.env` if 3001 is in use. If you change the port, use that port in the
browser URL as well.

The local SilverInk page is installed at
`Library/ppenguin/SilverInk.md`, with its bundle beside it. SilverBullet loads
that local bundle. After editing SilverInk, run `make -C _test start` again to
rebuild and copy it, then run **Sync: Now** and **Plugs: Reload** in the
client. No Git push or Library refresh is needed for this local copy.

The `Repositories/ppenguin.md` page is also in the Space so the repository
appears in Library UI. On this development branch, its remote entries point
to GitHub `silverink`. To test the just-built local bundle, use the installed
local library rather than the remote **Install** action, which fetches the
pushed GitHub version.

QuickAccess is installed as a local Space Lua library. After changing its
page, rerun `make -C _test start`, then run **Sync: Now** and
**System: Reload**. Its **QuickAccess** button stays visible in the top bar on
narrow screens and opens a tap-friendly picker for Quick Note, plug reload, and
SilverInk.

Useful commands:

```sh
make -C _test logs
make -C _test stop
```

LAN access over plain HTTP supports online testing. SilverBullet's offline
client features require localhost or HTTPS, so use localhost or put HTTPS in
front of the test server for offline recovery tests on another device.

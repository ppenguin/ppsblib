SILVERINK := ../src/SilverInk
SPACE := testspace

SILVERINK_SOURCES := $(wildcard $(SILVERINK)/*.ts) $(SILVERINK)/silverink.plug.yaml \
  $(SILVERINK)/tsconfig.json $(SILVERINK)/ui $(wildcard $(SILVERINK)/ui/*)
SPACE_FILES := $(SPACE)/Repositories/ppenguin.md \
  $(SPACE)/CONFIG.md \
  $(SPACE)/Library/ppenguin/theme-pp-dark.md \
  $(SPACE)/Library/ppenguin/SilverInk.md \
  $(SPACE)/Library/ppenguin/silverink.plug.js \
  $(SPACE)/Library/ppenguin/QuickAccess.md

.PHONY: start stop logs status

start: .env $(SPACE_FILES)
	docker compose up -d
	@printf 'SilverBullet is ready at your host address and port from _test/.env\n'
	@printf 'Login credentials are in the same file.\n'

.env:
	@umask 077; password=$$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n'); \
	printf 'SILVERBULLET_TEST_AUTH=inktest:%s\nSILVERBULLET_TEST_PORT=3001\n' "$$password" > "$@"

$(SILVERINK)/node_modules/.package-lock.json: $(SILVERINK)/package.json $(SILVERINK)/package-lock.json
	cd "$(SILVERINK)" && devenv shell -- npm ci

$(SILVERINK)/silverink.plug.js: $(SILVERINK_SOURCES) \
	$(SILVERINK)/package.json $(SILVERINK)/devenv.nix $(SILVERINK)/devenv.yaml \
	$(SILVERINK)/node_modules/.package-lock.json
	cd "$(SILVERINK)" && devenv shell -- npm run build

$(SPACE)/Repositories/ppenguin.md: ../Repositories/ppenguin.md
	@mkdir -p "$(@D)"
	cp "$<" "$@"

$(SPACE)/CONFIG.md: CONFIG.md
	@mkdir -p "$(@D)"
	cp "$<" "$@"

$(SPACE)/Library/ppenguin/theme-pp-dark.md: ../src/Theme/theme-pp-dark.md
	@mkdir -p "$(@D)"
	cp "$<" "$@"

$(SPACE)/Library/ppenguin/SilverInk.md: $(SILVERINK)/PLUG.md
	@mkdir -p "$(@D)"
	cp "$<" "$@"

$(SPACE)/Library/ppenguin/silverink.plug.js: $(SILVERINK)/silverink.plug.js
	@mkdir -p "$(@D)"
	cp "$<" "$@"

$(SPACE)/Library/ppenguin/QuickAccess.md: ../src/QuickAccess/QuickAccess.md
	@mkdir -p "$(@D)"
	cp "$<" "$@"

stop:
	docker compose down

logs:
	docker compose logs -f

status:
	docker compose ps

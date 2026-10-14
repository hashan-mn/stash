UUID    := stash@hashan-mn.github.io
SRC     := $(UUID)
BUILD   := build
ZIP     := $(BUILD)/$(UUID).shell-extension.zip

SOURCES := $(shell find $(SRC) -type f -name '*.js') \
           $(SRC)/metadata.json $(SRC)/stylesheet.css

.PHONY: all install enable disable schemas zip clean dev logs lint

all: schemas

## Compile the GSettings schema in place
schemas:
	@glib-compile-schemas $(SRC)/schemas
	@echo "schema compiled"

## Symlink into ~/.local/share/gnome-shell/extensions
install:
	@tools/install.sh

enable:
	@gnome-extensions enable $(UUID)

disable:
	@gnome-extensions disable $(UUID)

## Run a nested shell for safe testing
dev:
	@tools/dev-nested.sh

logs:
	@tools/logs.sh

## Basic syntax check across every source file
lint:
	@fail=0; \
	for f in $(SOURCES); do \
	    case "$$f" in \
	    *.js) node --check "$$f" >/dev/null 2>&1 || { echo "SYNTAX: $$f"; fail=1; };; \
	    *.json) python3 -c "import json,sys; json.load(open('$$f'))" || fail=1;; \
	    esac; \
	done; \
	xmllint --noout $(SRC)/schemas/*.xml 2>/dev/null || true; \
	[ $$fail -eq 0 ] && echo "lint ok" || { echo "lint failed"; exit 1; }

## Build a bundle suitable for extensions.gnome.org
zip: schemas
	@mkdir -p $(BUILD)
	@rm -f $(ZIP)
	@cd $(SRC) && zip -qr ../$(ZIP) . \
	    -x '*.git*' -x '*~' -x '*.zip' -x 'src/*-hook.js'
	@echo "built $(ZIP)"
	@unzip -l $(ZIP) | tail -1

clean:
	@rm -rf $(BUILD)
	@rm -f $(SRC)/schemas/gschemas.compiled
	@echo "cleaned"

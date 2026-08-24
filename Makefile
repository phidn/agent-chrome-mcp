# agent-chrome-mcp
#
# Usage:
#   make                   # show this help (default target)
#   make menu              # interactive menu to pick a target
#   make install IDS="<extension-id> [extension-id-2] ..."
#   make uninstall
#   make chrome            # launch Chrome with the silent-debugger flag
#   make chrome APP="Brave Browser"
#   make chrome-app        # create "/Applications/Chrome MCP.app" (Spotlight launcher)
#   make chrome-remove     # delete the launcher app (Google Chrome itself is untouched)

.PHONY: help menu install uninstall chrome chrome-app chrome-remove

.DEFAULT_GOAL := help

CHROME_APP := /Applications/Chrome MCP.app

help:
	@echo "Targets:"
	@echo "  make menu                               Interactive menu to pick a target"
	@echo "  make install IDS=\"<extension-id> ...\"   Register native messaging host"
	@echo "  make uninstall                          Remove manifests and wrapper script"
	@echo "  make chrome [APP=\"Brave Browser\"]       Launch browser without the debugger banner"
	@echo "  make chrome-app                         Create '$(CHROME_APP)' for Spotlight"
	@echo "  make chrome-remove                      Delete '$(CHROME_APP)' (keeps Google Chrome)"

menu:
	@echo "agent-chrome-mcp — pick a target:"; \
	echo "  1) install         Register native messaging host"; \
	echo "  2) uninstall       Remove manifests and wrapper script"; \
	echo "  3) chrome          Launch browser without the debugger banner"; \
	echo "  4) chrome-app      Create '$(CHROME_APP)' for Spotlight"; \
	echo "  5) chrome-remove   Delete '$(CHROME_APP)' (keeps Google Chrome)"; \
	echo "  q) quit"; \
	printf "Choice: "; read choice; \
	case "$$choice" in \
		1) printf "Extension IDs (space-separated): "; read ids; $(MAKE) install IDS="$$ids" ;; \
		2) $(MAKE) uninstall ;; \
		3) printf "Browser app [Google Chrome]: "; read app; $(MAKE) chrome APP="$$app" ;; \
		4) $(MAKE) chrome-app ;; \
		5) $(MAKE) chrome-remove ;; \
		q|Q|"") echo "Bye." ;; \
		*) echo "Unknown choice: $$choice"; exit 1 ;; \
	esac

install:
	./scripts/install.sh $(IDS)

uninstall:
	./scripts/uninstall.sh

chrome:
	./scripts/chrome-mcp.sh $(if $(APP),"$(APP)")

chrome-app:
	osacompile -o "$(CHROME_APP)" -e 'do shell script "open -a \"Google Chrome\" --args --silent-debugger-extension-api"'
	cp "/Applications/Google Chrome.app/Contents/Resources/app.icns" "$(CHROME_APP)/Contents/Resources/applet.icns"
	codesign --force --sign - "$(CHROME_APP)"
	@echo "Created $(CHROME_APP) — Cmd+Space 'Chrome MCP' to launch without the banner."

chrome-remove:
	rm -rf "$(CHROME_APP)"
	@echo "Removed $(CHROME_APP) (Google Chrome itself is untouched)."

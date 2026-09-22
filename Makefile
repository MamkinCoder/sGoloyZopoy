# Convenience wrappers around scripts/ (run on the Mac). PI_HOST is the ssh alias of the Pi.
# Slow targets (install-pi, deploy) are meant to be run by a human, not by an agent.
PI_HOST ?= rpi-ts
PI_APP  ?= /opt/sgz/app
PI_DATA ?= /opt/sgz/data
export PI_HOST PI_APP PI_DATA

.PHONY: help build typecheck test check-leaks deploy sync-data status logs install-pi rollback backup-db

help:
	@echo "make build        typecheck + build web and server, embed SPA into packages/server/spa"
	@echo "make test         pnpm -r test"
	@echo "make check-leaks  scan tracked files for personal data / secrets (run before git push)"
	@echo "make install-pi   copy deploy/ + scripts/ to the Pi and run scripts/install-pi.sh there (interactive)"
	@echo "make sync-data    data/ -> $(PI_HOST):$(PI_DATA)"
	@echo "make deploy       build + rsync app + pnpm install --prod + restart sgz on the Pi"
	@echo "make status       free -m, systemctl status sgz, health, last 30 log lines"
	@echo "make logs         journalctl -fu sgz on the Pi"
	@echo "make rollback     restore $(PI_APP).prev on the Pi and restart"
	@echo "make backup-db    sqlite3 .backup on the Pi, copy to data/backups/"

build:
	pnpm -r typecheck
	pnpm --filter @sgz/shared build
	pnpm --filter @sgz/web build
	pnpm --filter @sgz/server build
	rm -rf packages/server/spa && cp -R packages/web/dist packages/server/spa

typecheck:
	pnpm -r typecheck

test:
	pnpm -r test

check-leaks:
	bash scripts/check-leaks.sh

deploy:
	bash scripts/deploy.sh

sync-data:
	bash scripts/sync-data.sh

status:
	bash scripts/pi-status.sh

logs:
	ssh -t $(PI_HOST) journalctl -fu sgz

install-pi:
	rsync -az --delete deploy scripts package.json $(PI_HOST):/tmp/sgz-install/
	ssh -t $(PI_HOST) bash /tmp/sgz-install/scripts/install-pi.sh

rollback:
	ssh $(PI_HOST) 'test -f $(PI_APP).prev/RELEASE || { echo "no previous release at $(PI_APP).prev"; exit 1; }; \
	  echo "rolling back to: $$(cat $(PI_APP).prev/RELEASE)"; sudo systemctl stop sgz; \
	  rsync -a --delete $(PI_APP).prev/ $(PI_APP)/; sudo systemctl start sgz; sleep 3; systemctl is-active sgz'

backup-db:
	mkdir -p data/backups
	ssh $(PI_HOST) 'mkdir -p /opt/sgz/backups && sqlite3 $(PI_DATA)/sgz.db ".backup /opt/sgz/backups/sgz-$$(date +%F).db" && ls -la /opt/sgz/backups | tail -3'
	rsync -az $(PI_HOST):/opt/sgz/backups/ data/backups/

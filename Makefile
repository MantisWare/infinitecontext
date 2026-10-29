.PHONY: premerge emu-up emu-down guard

premerge:
	cd apps/js-sdk && npm run premerge

emu-up:
	cd apps/js-sdk && npm run storage:emu:up

emu-down:
	cd apps/js-sdk && npm run storage:emu:down

guard:
	cd apps/js-sdk && npm run guard:12

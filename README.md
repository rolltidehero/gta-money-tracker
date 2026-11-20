# GTA Money Tracker

Chapter-by-chapter GTA VI earning routes, legitimate earner comparisons, and a filterable matrix of money exploits, built-in cheats, duplication claims and hoaxes. [Live page](https://rolltidehero.github.io/gta-money-tracker/).

Evidence tiers describe how a claim is supported, not a measured success rate. Reported payouts and locations come from the cited guides. The separate [Car Tracker](https://rolltidehero.github.io/gta-car-tracker/) covers vehicle prices and Wish List spots, and the [Glitch Tracker](https://rolltidehero.github.io/gta-glitch-tracker/) covers physics reports.

## Update the tracker

Edit `tracker-data.json` and run `node update-tracker.js` with Node.js 18 or newer. The script validates source keys and plan references, rebuilds `data.js`, `exports/gta6_money_tracker.csv` and `feed.xml`, runs self-tests, and commits and pushes changes. Use `--dry-run` to validate without writing, `--no-push` to build and commit locally, or `--help` for all options.

The same script runs in all three repos and uses `meta.repo` to identify the app. When a shared citation changes, `node update-tracker.js --sync-sources --dry-run` previews which sibling checkouts would be updated. Run without `--dry-run` to apply the changes.

## Automatic refresh

GitHub Actions runs every four hours at minute 53 UTC. The workflow builds and updates the site, then checks the duplication-claim watch for items that need review. The watch cannot verify a claim on its own.

## RSS and version

Select **Get RSS alerts!** or add the [public feed](https://rolltidehero.github.io/gta-money-tracker/feed.xml) to your reader. The feed keeps the 25 most recent content updates and skips date-only checks. The page footer shows the latest GitHub commit.

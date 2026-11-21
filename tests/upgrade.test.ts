/**
 * An in-place upgrade from the build mainnet runs. The earlier build is set up
 * and left in a story and paused, this build is deployed over it, every
 * account is compared, the runbook runs up to the activation of the layout
 * (the trigger books, the scan of the seats, and the abort, which redeploys
 * the earlier build and back), the market and the USDC guard are rebound to
 * MagicBlock's oracle, and trading resumes on the state the earlier build
 * left. The access lists' audit then runs on that state, and the limit on
 * perp markets closes it. Run by `make test-upgrade`.
 */
import "./upgrade/before-upgrade";
import "./upgrade/deploy-and-compare";
import "./upgrade/runbook";
import "./upgrade/after-upgrade";
import "./audit/access-lists";
import "./upgrade/market-limit";

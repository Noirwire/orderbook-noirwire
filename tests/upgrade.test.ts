/**
 * An in-place upgrade from the build mainnet runs. The earlier build is set up
 * and left in a story and paused, this build is deployed over it, every
 * account is compared, the market and the USDC guard are rebound to
 * MagicBlock's oracle, and trading resumes on the state the earlier build left.
 * The access lists' audit then runs on that state. Run by `make test-upgrade`.
 */
import "./upgrade/before-upgrade";
import "./upgrade/deploy-and-compare";
import "./upgrade/after-upgrade";
import "./audit/access-lists";

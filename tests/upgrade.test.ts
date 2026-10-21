/**
 * The order book's story on an earlier build of the program, this build
 * deployed over it in place, then the access lists' audit on the state the
 * earlier build left. Run by `make test-upgrade`.
 */
import "./orderbook.test";
import "./audit/upgrade-in-place";
import "./audit/access-lists";

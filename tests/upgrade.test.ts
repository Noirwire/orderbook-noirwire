/**
 * The order book's story on an earlier build of the program, the state that
 * build is left in, this build deployed over it in place, the relayout of the
 * earlier ledger, and then the access lists' audit on the state the earlier
 * build left. Run by `make test-upgrade`.
 */
import "./orderbook.test";
import "./audit/earlier-state";
import "./audit/upgrade-in-place";
import "./audit/relayout";
import "./audit/access-lists";

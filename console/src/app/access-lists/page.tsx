import { Heading } from "@/components/bits";

export default function AccessListsPage() {
  return (
    <>
      <Heading
        title="Access lists"
        lead="The maker list, the trader list and the blocked list, with the maker and trader access switches. This page is a placeholder: the client this console is built against has no set_market_access or set_seat_access yet, so nothing on this page reads or sends anything."
      />
      <section className="notice">
        <h2>Not available in this build</h2>
        <p>
          Build the console against a client that has the access list
          instructions and this page gains their actions, each reviewed before
          the wallet signs like every other action.
        </p>
      </section>
    </>
  );
}

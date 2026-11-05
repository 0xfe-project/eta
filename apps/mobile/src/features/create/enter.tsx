import { nav } from "../../nav/stack";
import { ChatScreen } from "../chat";

/** Leave the `pages` of a finished form for the chat it made: back from there is the list. */
export function enterChat(id: string, pages = 1): void {
  const routes = nav.routes();
  nav.setRoutes([
    ...routes.slice(0, routes.length - pages),
    { key: `chat:${id}`, page: () => <ChatScreen id={id} /> },
  ]);
}

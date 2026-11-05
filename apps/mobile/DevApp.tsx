// The app against the fake host, in the simulator and in `nsh test`: no network, the design's data.
import { mount } from "nsh";
import { Root } from "./src/app/Root";
import { useFakeHost } from "./src/testing/fake-host";

useFakeHost();
mount(Root);

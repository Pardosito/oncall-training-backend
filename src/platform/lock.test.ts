import { describeLockContract } from "../test-support/lock.contract.js";
import { createFixedClock } from "./clock.js";
import { createInMemoryLock } from "./lock.js";

describeLockContract("in-memory", () => {
  const clock = createFixedClock();
  return {
    lock: createInMemoryLock(clock),
    advance: (ms) => {
      clock.advance(ms / 1000);
      return Promise.resolve();
    },
  };
});

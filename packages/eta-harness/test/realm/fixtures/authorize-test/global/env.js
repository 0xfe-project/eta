// @capabilities [{"name":"sameName","source":"function() { return \"global\"; }","meta":{"desc":"test"}}]

import eta from "eta";
eta.define("sameName", function() { return "global"; }, { desc: "test" });

// eta:capability sameName
eta.define("sameName", function() { return "global"; }, {"desc":"test"});
// eta:end

// eta:by hand — everything below is kept as written.

// @capabilities [{"name":"sameName","source":"function() { return \"project\"; }","meta":{"desc":"test"}}]

import eta from "eta";
eta.define("sameName", function() { return "project"; }, { desc: "test" });

// eta:capability sameName
eta.define("sameName", function() { return "project"; }, {"desc":"test"});
// eta:end

// eta:by hand — everything below is kept as written.

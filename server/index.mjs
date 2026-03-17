import "dotenv/config";
import { app } from "./app.mjs";

const port = Number(process.env.PORT || 8787);

app.listen(port, () => {
  console.log(`Voice review desk running at http://localhost:${port}`);
  console.log(
    `Demo accounts: ${process.env.DEMO_OPERATOR_USERNAME ?? "operator"} / ${
      process.env.DEMO_OPERATOR_PASSWORD ?? "operator123"
    }, ${process.env.DEMO_EXPERT_USERNAME ?? "expert"} / ${
      process.env.DEMO_EXPERT_PASSWORD ?? "expert123"
    }`,
  );
});

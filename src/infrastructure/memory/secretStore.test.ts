/**
 * SecretStore 内存实现（R005 阶段 8 §8.2）：跑共享契约套件。
 */
import { InMemorySecretStore } from "./secretStore";
import { describeSecretStoreContract } from "../../test/secretStoreContract";

describeSecretStoreContract("内存", () => new InMemorySecretStore());

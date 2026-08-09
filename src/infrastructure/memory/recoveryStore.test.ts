/**
 * InMemoryRecoveryStore 测试（R005 阶段 8 §8.1）：与 Web localStorage
 * 实现共用契约套件，保证内存容器与生产容器恢复缓冲语义一致。
 */
import { describeRecoveryStoreContract } from "../../test/recoveryStoreContract";
import { InMemoryRecoveryStore } from "./recoveryStore";

describeRecoveryStoreContract("内存", () => new InMemoryRecoveryStore());

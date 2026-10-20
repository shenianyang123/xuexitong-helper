import { verifyArtifacts } from '../scripts/verify-core.mjs';

try {
    const checked = verifyArtifacts();
    console.log(`产物校验通过：${checked} 个文件与 src/ 源码同步且语法有效。`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}

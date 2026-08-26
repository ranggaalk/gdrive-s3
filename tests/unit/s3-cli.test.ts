import { describe, expect, test } from "bun:test";
import {
  credentialSetupExample,
  documentationSetupExample,
  s3CommandExamples,
} from "../../apps/web/src/lib/s3-cli.ts";

const config = {
  s3Endpoint: "http://localhost:3000",
  s3Region: "ap-southeast-3",
};

describe("S3 CLI examples", () => {
  test("uses the configured backend endpoint and region", () => {
    const output = credentialSetupExample(config, {
      accessKeyId: "AKIATESTKEY",
      secretAccessKey: "test-secret",
    });

    expect(output).toContain("http://localhost:3000");
    expect(output).toContain("ap-southeast-3");
    expect(output).toContain("AKIATESTKEY");
    expect(output).toContain("test-secret");
    expect(output).not.toContain("5173");
    expect(output).not.toContain("us-east-1");
  });

  test("uses inert placeholders in documentation", () => {
    const output = documentationSetupExample(config, {
      accessKeyId: "ACCESS_KEY_ID_ANDA",
      secretAccessKey: "SECRET_ACCESS_KEY_ANDA",
    });
    expect(output).toContain("ACCESS_KEY_ID_ANDA");
    expect(output).toContain("SECRET_ACCESS_KEY_ANDA");
    expect(output).not.toContain("test-secret");
  });

  test("adds endpoint and path-style targets to every S3 operation", () => {
    const commands = s3CommandExamples(config, "nama-bucket");
    for (const command of Object.values(commands)) {
      expect(command).toContain("--endpoint-url 'http://localhost:3000'");
    }
    expect(commands.upload).toContain("s3://nama-bucket/file.txt");
    expect(commands.list).toContain("s3://nama-bucket/");
  });

  test("quotes shell-sensitive configuration values", () => {
    const output = documentationSetupExample(
      {
        s3Endpoint: "https://s3.example.test/it's-here",
        s3Region: "region with spaces",
      },
      { accessKeyId: "ACCESS_KEY_ID_ANDA", secretAccessKey: "SECRET_ACCESS_KEY_ANDA" },
    );
    expect(output).toContain(`'https://s3.example.test/it'"'"'s-here'`);
    expect(output).toContain("'region with spaces'");
  });
});

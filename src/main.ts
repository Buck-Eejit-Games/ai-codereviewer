import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

console.log("Starting AI Code Reviewer action... (initial log)");

// Log all inputs early to verify they are being set correctly
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const includePatternsInput: string = core.getInput("include");

if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN is missing.");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY is missing.");
  process.exit(1);
}
if (!OPENAI_API_MODEL) {
  console.error("Warning: OPENAI_API_MODEL is not provided. Defaulting to gpt-4o.");
}
if (!includePatternsInput) {
  console.error("Warning: include patterns are not provided.");
}

console.log("Inputs retrieved successfully:");
console.log("GITHUB_TOKEN: [REDACTED]");
console.log("OPENAI_API_KEY: [REDACTED]");
console.log("OPENAI_API_MODEL:", OPENAI_API_MODEL);
console.log("Include patterns:", includePatternsInput);

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  console.log("Fetching PR details...");
  if (!process.env.GITHUB_EVENT_PATH) {
    console.error("Error: GITHUB_EVENT_PATH is not defined.");
    process.exit(1);
  }
  const { repository, number } = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
  );
  console.log("Repository and PR number retrieved from event data:", repository, number);
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  console.log("PR details fetched from GitHub:", prResponse.data);
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
    owner: string,
    repo: string,
    pull_number: number
): Promise<string | null> {
  console.log("Fetching diff for PR...");
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  console.log("Diff fetched:", response.data);
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
    parsedDiff: File[],
    prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  console.log("Analyzing code...");
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    console.log("Processing file:", file.to);
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      console.log("Processing chunk:", chunk.content);
      const prompt = createPrompt(file, chunk, prDetails);
      console.log("Prompt sent to OpenAI:", prompt); // Log the prompt
      try {
        const aiResponse = await getAIResponse(prompt);
        const parsedResponse = JSON.parse(aiResponse);
        console.log("Parsed response from OpenAI:", parsedResponse); // Log the parsed response
        if (aiResponse) {
          const newComments = createComment(file, chunk, aiResponse);
          if (newComments) {
            comments.push(...newComments);
          }
        }
      } catch (error) {
        console.error("Error getting AI response:", error);
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in the following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: Provide JSON without wrapping it in code blocks.

Review the following code diff in the file "${
      file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")}
\`\`\`
`;
}

function sanitizeAIResponse(response: string): string {
  // Remove code block markers if they exist
  return response.replace(/```(?:json)?|```/g, "").trim();
}

async function getAIResponse(prompt: string): Promise<string> {
  console.log("Sending prompt to OpenAI...");
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    // console.log("OpenAI response received (raw):", response);
    let res = response.choices[0].message?.content?.trim() || "{}";

    // Sanitize response before returning
    res = sanitizeAIResponse(res);

    return res;
  } catch (error) {
    console.error("Error getting AI response:", error);
    console.error("Prompt that caused error:", prompt);
    return "{}";
  }
}

function createComment(
    file: File,
    chunk: Chunk,
    aiResponse: string
): Array<{ body: string; path: string; line: number }> {
  try {
    const reviews = JSON.parse(aiResponse).reviews;
    return reviews.flatMap((review: { lineNumber: string; reviewComment: string }) => {
      if (!file.to) {
        return [];
      }
      return {
        body: review.reviewComment,
        path: file.to,
        line: Number(review.lineNumber),
      };
    });
  } catch (error) {
    console.error("Error parsing AI response JSON:", error);
    console.error("AI response was:", aiResponse);
    return [];
  }
}

async function createReviewComment(
    owner: string,
    repo: string,
    pull_number: number,
    comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  console.log("Creating review comment on GitHub...");
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
  console.log("Review comment created.");
}

async function main() {
  console.log("Starting main function...");
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  console.log("Event data:", eventData);

  if (eventData.action === "opened") {
    diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    console.log("Fetching diff for synchronized event...");
    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  console.log("Diff found, parsing...");
  const parsedDiff = parseDiff(diff);
  console.log("Parsed Diff:", parsedDiff); // Log parsed diff

  const includePatterns = includePatternsInput
      .split(",")
      .map((s) => s.trim());

  console.log("Include patterns:", includePatterns);

  const filteredDiff = parsedDiff.filter((file) => {
    return includePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
    );
  });
  console.log("Filtered Diff:", filteredDiff); // Log filtered diff

  if (filteredDiff.length === 0) {
    console.log("No files matched the include patterns.");
    return;
  }

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    console.log("Comments generated:", comments);
    await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
    );
  } else {
    console.log("No comments generated.");
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
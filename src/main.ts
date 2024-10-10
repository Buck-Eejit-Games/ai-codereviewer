import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import path from "path";

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
  uniqueCommits: string[];
}

async function getPRDetails(): Promise<PRDetails> {
  console.log("Fetching PR details...");

  // Authenticate Octokit using GITHUB_TOKEN
  const token = core.getInput("GITHUB_TOKEN") || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN is required but not provided.");
    process.exit(1);
  }
  const octokit = new Octokit({ auth: token });

  let pull_number: number | undefined;
  let owner: string | undefined;
  let repo: string | undefined;

  // Check for event path and read event data
  if (process.env.GITHUB_EVENT_PATH) {
    const eventData = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (eventData.pull_request) {
      pull_number = eventData.pull_request.number;
      owner = eventData.repository?.owner?.login;
      repo = eventData.repository?.name;
    } else if (eventData.inputs && eventData.inputs.pull_number) {
      pull_number = parseInt(eventData.inputs.pull_number, 10);
      owner = eventData.repository?.owner?.login;
      repo = eventData.repository?.name;
    }
  }

  // If GITHUB_EVENT_PATH does not provide necessary information, fallback to input
  if (!pull_number) {
    pull_number = parseInt(core.getInput("pull_number"));
    if (!pull_number) {
      console.error("Error: pull_number input is required but not provided.");
      process.exit(1);
    }
  }

  // Get owner and repo from GITHUB_REPOSITORY environment variable if not set
  if (!owner || !repo) {
    if (!process.env.GITHUB_REPOSITORY) {
      console.error("Error: GITHUB_REPOSITORY is not defined.");
      process.exit(1);
    }
    [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  }

  if (!owner || !repo) {
    console.error("Error: Unable to determine repository owner and name.");
    process.exit(1);
  }

  console.log(`Repository details: owner=${owner}, repo=${repo}, pull_number=${pull_number}`);

  try {
    // Fetch pull request details using octokit
    const prResponse = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
    });

    console.log("Successfully fetched PR details.");

    // Get unique commits for the pull request
    const uniqueCommits = await getUniquePRCommits(pull_number, owner, repo, octokit);

    return {
      owner,
      repo,
      pull_number,
      title: prResponse.data.title ?? "",
      description: prResponse.data.body ?? "",
      uniqueCommits,
    };
  } catch (error: any) {
    console.error("Error fetching PR details:", error);
    if (error.status === 404) {
      console.error(`Error: Pull request #${pull_number} not found in repository ${owner}/${repo}.`);
    }
    process.exit(1);
  }
}

async function getUniquePRCommits(pull_number: number, owner: string, repo: string, octokit: Octokit): Promise<string[]> {
  console.log(`Fetching unique commits for PR #${pull_number}...`);

  try {
    // Get all open pull requests for the repository
    const allPRs = await octokit.pulls.list({
      owner,
      repo,
      state: "open",
    });

    // Collect commits of all open pull requests excluding the current one
    const allOtherCommits = new Set<string>();
    for (const pr of allPRs.data) {
      if (pr.number !== pull_number) {
        const commits = await octokit.pulls.listCommits({
          owner,
          repo,
          pull_number: pr.number,
        });

        for (const commit of commits.data) {
          allOtherCommits.add(commit.sha);
        }
      }
    }

    // Get the commits of the current pull request
    const currentPRCommits = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number,
    });

    // Filter out commits that are present in other open pull requests
    const uniqueCommits = currentPRCommits.data
        .filter(commit => !allOtherCommits.has(commit.sha))
        .map(commit => commit.sha);

    console.log(`Successfully fetched unique commits for PR #${pull_number}.`);
    return uniqueCommits;
  } catch (error: any) {
    console.error("Error fetching unique commits:", error);
    throw error; // Let the caller handle the error
  }
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
  //console.log("Diff fetched:", response.data);
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
      console.log("Processing chunk");
      const prompt = createPrompt(file, chunk, prDetails);
      console.log("Prompt sent to OpenAI"); // Log the prompt
      try {
        const aiResponse = await getAIResponse(prompt);
        const parsedResponse = JSON.parse(aiResponse);
        //console.log("Parsed response from OpenAI:", parsedResponse); // Log the parsed response
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
- NEVER talk about comments in the code or adding comments. (IMPORTANT)
- Do not give positive comments or compliments.
- Assume any variable you come across is defined, initialized and used correctly. (IMPORTANT)
- Assume any function you come across is defined, works and used correctly. (IMPORTANT)
- If code is removed, assume it was necessary to remove it unless you have reference to the full context and don't comment on it.
- Don't comment on renaming variable names, function names, or parameter names, unless they are completely incorrect.
- Don't comment on checking for null or undefined unless it is completely incorrect.
- Don't comment on formatting.
- Don't comment about checking for zero or invalid values.
- Remember to be aware of up to date coding practices.
- Provide suggestions ONLY if there is something to improve, and provide reasons for it, otherwise "reviews" should be an empty array.
- Always try to provide code examples or snippets to support your suggestions.
- Context is important, so make sure to provide suggestions based on the context of the code and not to invent new context.
- If there is no context, assume it is a part of a valid function or method.
- Ensure you differentiate between code in different files.
- If provide code suggestions, if they are single line wrap them in single backticks, if they are multi-line wrap them in triple backticks on separate lines.
- If you do not know the context of the code, you can assume it is a part of a function or method, and you can assume the function signature or variable type is correct.
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

    //console.log("OpenAI response received (raw):", response);
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
    comments: Array<{ body: string; path: string; line?: number }>
): Promise<void> {
  console.log("Fetching pull request files...");

  // Step 1: Fetch files and their diff information from the pull request
  const prFiles = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number,
  });

  const fileDiffs = prFiles.data;

  // A helper function to get the diff position for a specific line in a file
  const getDiffPosition = (path: string, line: number | undefined): number | null => {
    if (!line) return null;

    const fileDiff = fileDiffs.find(file => file.filename === path);
    if (!fileDiff || !fileDiff.patch) return null;

    // Extract diff information for the file
    const diffLines = fileDiff.patch.split("\n");

    let currentLineInDiff = 0;
    let positionInDiff = 0;

    for (let i = 0; i < diffLines.length; i++) {
      const diffLine = diffLines[i];
      positionInDiff++; // Always increment the position

      // Lines starting with @@ indicate a new hunk with line numbers
      if (diffLine.startsWith("@@")) {
        const match = diffLine.match(/@@ \-(\d+),\d+ \+(\d+),\d+ @@/);
        if (match) {
          const startingLine = parseInt(match[2], 10);
          currentLineInDiff = startingLine;
        }
      } else if (!diffLine.startsWith("-")) {
        // Increment line number count only for lines that aren't removed (not starting with "-")
        currentLineInDiff++;
      }

      // If we've reached the requested line, return the position
      if (currentLineInDiff === line) {
        return positionInDiff;
      }
    }

    return null;
  };

  const formattedComments: Array<{ body: string; path: string; position?: number }> = [];

  for (const comment of comments) {
    const diffPosition = getDiffPosition(comment.path, comment.line);

    if (diffPosition !== null && diffPosition !== undefined) {
      console.log(`Adding comment "${comment.body}" to ${comment.path} at line ${comment.line} with diff position ${diffPosition}`);
      // Step 2: Add valid line-specific comments with diff position
      formattedComments.push({
        body: comment.body,
        path: comment.path,
        position: diffPosition, // Use diff position
      });
    } else {
      console.log(`Invalid or missing line number for ${comment.path}, skipping.`);
      // Step 3: Fallback to general file-level comments if no valid diff position
      formattedComments.push({
        body: comment.body,
        path: comment.path, // General file comment, omit position
      });
      console.warn(`Invalid or missing line number (${comment.line}) for comment "${comment.body}" at ${comment.path}, adding as a file-level comment.`);
    }
  }

  // Step 4: Submit the review with all collected comments
  if (formattedComments.length > 0) {
    console.log("Submitting collected review comments...");
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments: formattedComments,
      event: "COMMENT",
    });
    console.log("Review comments submitted successfully.");
  } else {
    console.log("No valid comments to submit.");
  }
}

async function main() {
  console.log("Starting main function...");
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  console.log("Event action:", process.env.GITHUB_EVENT_NAME);
  console.log(process.env.GITHUB_EVENT_NAME === "workflow_dispatch");

  if (eventData.action === "opened" || process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
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
  parsedDiff.forEach(file => console.log("Parsed file path:", file.to)); // Log parsed file paths
  //console.log("Parsed Diff:", parsedDiff); // Log parsed diff

  // Get include patterns or use a default value if not provided
  let includePatternsInput: string = core.getInput("include") || "**/*.cs,**/*.yml";
  includePatternsInput = includePatternsInput.trim() ? includePatternsInput : "**/*.cs,**/*.yml";

  const includePatterns = includePatternsInput
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  console.log("Include patterns:", includePatterns);

  const filteredDiff = parsedDiff.filter((file) => {
    const normalizedPath = path.normalize(file.to ?? "");
    const match = includePatterns.some((pattern) => minimatch(normalizedPath, pattern));
    //console.log(`Checking if file "${normalizedPath}" matches patterns:`, match);
    return match;
  });
  //console.log("Filtered Diff:", filteredDiff); // Log filtered diff

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
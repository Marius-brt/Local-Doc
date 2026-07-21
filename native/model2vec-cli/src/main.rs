use anyhow::{Context, Result, bail};
use clap::Parser;
use model2vec::Model2Vec;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::PathBuf;

/// localdoc Model2Vec embedding sidecar ([model2vec](https://docs.rs/model2vec/latest/model2vec/)).
#[derive(Parser, Debug)]
#[command(name = "localdoc-model2vec", version, about)]
struct Args {
    /// Local model directory containing tokenizer.json, model.safetensors, config.json
    #[arg(long, short = 'm')]
    model: PathBuf,

    /// Override normalization (default: use model config)
    #[arg(long)]
    normalize: Option<bool>,

    /// Max tokens per text (default 512)
    #[arg(long, default_value_t = 512)]
    max_length: usize,

    /// Encode batch size
    #[arg(long, default_value_t = 256)]
    batch_size: usize,
}

#[derive(Deserialize)]
struct EncodeRequest {
    texts: Vec<String>,
}

#[derive(Serialize)]
struct EncodeResponse {
    dims: usize,
    embeddings: Vec<Vec<f32>>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn main() {
    if let Err(err) = run() {
        let _ = serde_json::to_writer(
            io::stdout(),
            &ErrorResponse {
                error: format!("{err:#}"),
            },
        );
        eprintln!("localdoc-model2vec: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = Args::parse();
    if !args.model.is_dir() {
        bail!("model path is not a directory: {}", args.model.display());
    }

    let model = Model2Vec::from_pretrained(&args.model, args.normalize, None)
        .with_context(|| format!("failed to load Model2Vec model from {}", args.model.display()))?;

    let mut raw = String::new();
    io::stdin()
        .read_to_string(&mut raw)
        .context("failed to read stdin")?;
    let raw = raw.trim();
    if raw.is_empty() {
        bail!("stdin is empty; expected JSON {{\"texts\":[\"...\"]}}");
    }

    let req: EncodeRequest = serde_json::from_str(raw).context("invalid JSON request on stdin")?;
    if req.texts.is_empty() {
        let out = EncodeResponse {
            dims: 0,
            embeddings: vec![],
        };
        serde_json::to_writer(io::stdout(), &out)?;
        return Ok(());
    }

    let matrix = model
        .encode_with_args(&req.texts, Some(args.max_length), args.batch_size)
        .context("encode failed")?;

    let dims = matrix.ncols();
    let mut embeddings = Vec::with_capacity(matrix.nrows());
    for row in matrix.rows() {
        embeddings.push(row.iter().copied().collect());
    }

    let out = EncodeResponse { dims, embeddings };
    serde_json::to_writer(io::stdout(), &out)?;
    Ok(())
}

/// Garante que `webapp/` exista antes do `include_bytes!` que embute o PWA
/// do celular no executável.
///
/// Quem preenche essa pasta de verdade é o `vite build -c
/// vite.mobile.config.ts`, que roda no `npm run build`. Mas um `cargo check`,
/// um `cargo test` ou um clone recém-feito acontecem sem passar por lá, e
/// `include_bytes!` de arquivo inexistente é erro de compilação — o Rust
/// inteiro deixaria de compilar por causa do front. Os arquivos de reserva
/// existem para esse buraco: eles não fingem ser o app, dizem em voz alta que
/// o build do front não rodou.
fn webapp_de_reserva() {
    use std::fs;
    use std::path::Path;

    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("webapp");
    println!("cargo:rerun-if-changed={}", dir.display());
    if fs::create_dir_all(&dir).is_err() {
        return;
    }

    let aviso = "JARVIS: o app do celular nao foi compilado. \
Rode `npm run build` (ou `npm run build:mobile`) e compile de novo.";
    let reservas: [(&str, String); 5] = [
        (
            "index.html",
            format!("<!doctype html><meta charset=utf-8><title>JARVIS</title><p>{aviso}"),
        ),
        ("app.js", format!("console.error({aviso:?});")),
        ("app.css", format!("/* {aviso} */")),
        ("sw.js", format!("/* {aviso} */")),
        (
            "manifest.webmanifest",
            r#"{"name":"JARVIS","start_url":"/","display":"standalone"}"#.to_string(),
        ),
    ];

    for (nome, conteudo) in reservas {
        let alvo = dir.join(nome);
        if !alvo.exists() {
            let _ = fs::write(alvo, conteudo);
        }
    }
}

fn main() {
    webapp_de_reserva();

    // Faz o `comctl32.dll` ser carregado só na primeira chamada, em vez de na
    // abertura do processo.
    //
    // Motivo: a camada de janelas do Tauri (via `muda`, com `common-controls-v6`
    // ligado) importa `TaskDialogIndirect`, que só existe na versão 6 do
    // comctl32. O aplicativo declara essa versão no manifesto que o
    // `tauri_build` embute e resolve o símbolo sem problema. Os binários de
    // `cargo test`, porém, não recebem manifesto nenhum: o carregador do
    // Windows encontra a versão 5, não acha o símbolo e mata o processo com
    // STATUS_ENTRYPOINT_NOT_FOUND antes da primeira linha de teste — sem dizer
    // por quê.
    //
    // Embutir um manifesto só para os testes não é possível: as diretivas
    // `rustc-link-arg-bins`/`-tests` não alcançam o executável de teste da
    // própria lib, e `rustc-link-arg` (que alcança) valeria também para o
    // aplicativo, onde um segundo manifesto colide com o do Tauri
    // (`CVT1100: recurso duplicado`).
    //
    // Adiar o carregamento resolve os dois casos com o mesmo argumento e sem
    // exceção: os testes nunca chamam `TaskDialogIndirect`, então para eles o
    // comctl32 simplesmente nunca é carregado; no aplicativo, quando a
    // chamada acontece, o contexto de ativação do manifesto já vale há muito
    // tempo e a versão 6 é encontrada como antes.
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
        // O auxiliar que resolve a importação na primeira chamada. Vai como
        // argumento de linkagem, e não como `rustc-link-lib`: este último faz
        // o rustc procurar o arquivo nos caminhos que ele conhece, e o
        // `delayimp.lib` mora nos diretórios do MSVC, que só o linkador tem.
        println!("cargo:rustc-link-arg=delayimp.lib");
    }

    tauri_build::build()
}

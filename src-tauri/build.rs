fn main() {
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
